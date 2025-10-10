import { reconcileElements } from "@excalidraw/excalidraw";
import { MIME_TYPES } from "@excalidraw/common";
import { decompressData } from "@excalidraw/excalidraw/data/encode";
import {
  encryptData,
  decryptData,
} from "@excalidraw/excalidraw/data/encryption";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";
import { getSceneVersion } from "@excalidraw/element";
import { initializeApp } from "firebase/app";
import {
  getFirestore,
  doc,
  getDoc,
  runTransaction,
  Bytes,
} from "firebase/firestore";
import { getStorage, ref, uploadBytes } from "firebase/storage";

import type { RemoteExcalidrawElement } from "@excalidraw/excalidraw/data/reconcile";
import type {
  ExcalidrawElement,
  FileId,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFileMetadata,
  DataURL,
} from "@excalidraw/excalidraw/types";

import { FILE_CACHE_MAX_AGE_SEC } from "../app_constants";

import { getSyncableElements } from ".";

import type { SyncableExcalidrawElement } from ".";
import type Portal from "../collab/Portal";
import type { Socket } from "socket.io-client";

// private
// -----------------------------------------------------------------------------

let FIREBASE_CONFIG: Record<string, any>;
try {
  FIREBASE_CONFIG = JSON.parse(import.meta.env.VITE_APP_FIREBASE_CONFIG);
} catch (error: any) {
  console.warn(
    `Error JSON parsing firebase config. Supplied value: ${
      import.meta.env.VITE_APP_FIREBASE_CONFIG
    }`,
  );
  FIREBASE_CONFIG = {};
}

let firebaseApp: ReturnType<typeof initializeApp> | null = null;
let firestore: ReturnType<typeof getFirestore> | null = null;
let firebaseStorage: ReturnType<typeof getStorage> | null = null;

const FIREBASE_REQUIRED_KEYS = [
  "apiKey",
  "projectId",
  "storageBucket",
] as const;
const isFirebaseConfigured = FIREBASE_REQUIRED_KEYS.every((key) => {
  const value = FIREBASE_CONFIG?.[key];
  return typeof value === "string" && value.length > 0;
});

if (!isFirebaseConfigured) {
  console.info(
    "Firebase config missing or incomplete. Collaboration will fall back to socket-only mode without persistence.",
  );
}

const STORAGE_SERVER_URL = (() => {
  const raw =
    import.meta.env.VITE_APP_STORAGE_SERVER_URL ||
    import.meta.env.VITE_APP_WS_SERVER_URL;
  if (!raw) {
    return null;
  }
  if (/^ws(s)?:/i.test(raw)) {
    return raw.replace(/^ws/i, "http").replace(/\/+$/, "");
  }
  return raw.replace(/\/+$/, "");
})();

const uint8ArrayToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const base64ToUint8Array = (base64: string) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

const _initializeFirebase = () => {
  if (!isFirebaseConfigured) {
    return null;
  }
  if (!firebaseApp) {
    firebaseApp = initializeApp(FIREBASE_CONFIG);
  }
  return firebaseApp;
};

const _getFirestore = () => {
  const app = _initializeFirebase();
  if (!app) {
    return null;
  }
  if (!firestore) {
    firestore = getFirestore(app);
  }
  return firestore;
};

const _getStorage = () => {
  const app = _initializeFirebase();
  if (!app) {
    return null;
  }
  if (!firebaseStorage) {
    firebaseStorage = getStorage(app);
  }
  return firebaseStorage;
};

// -----------------------------------------------------------------------------

export const loadFirebaseStorage = async () => {
  return _getStorage();
};

type FirebaseStoredScene = {
  sceneVersion: number;
  iv: Bytes;
  ciphertext: Bytes;
};

type LocalStoredScene = {
  sceneVersion: number;
  iv: string;
  ciphertext: string;
  updatedAt?: number;
};

const encryptElements = async (
  key: string,
  elements: readonly ExcalidrawElement[],
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> => {
  const json = JSON.stringify(elements);
  const encoded = new TextEncoder().encode(json);
  const { encryptedBuffer, iv } = await encryptData(key, encoded);

  return { ciphertext: encryptedBuffer, iv };
};

const decryptElements = async (
  data: FirebaseStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = data.ciphertext.toUint8Array();
  const iv = data.iv.toUint8Array();

  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

const createLocalSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
): Promise<LocalStoredScene> => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext)),
    iv: uint8ArrayToBase64(iv),
    updatedAt: Date.now(),
  };
};

const decryptLocalScene = async (
  scene: LocalStoredScene,
  roomKey: string,
): Promise<readonly ExcalidrawElement[]> => {
  const ciphertext = base64ToUint8Array(scene.ciphertext);
  const iv = base64ToUint8Array(scene.iv);
  const decrypted = await decryptData(iv, ciphertext, roomKey);
  const decodedData = new TextDecoder("utf-8").decode(
    new Uint8Array(decrypted),
  );
  return JSON.parse(decodedData);
};

const fetchLocalSceneDocument = async (
  roomId: string,
): Promise<LocalStoredScene | null> => {
  if (!STORAGE_SERVER_URL) {
    return null;
  }
  const response = await fetch(
    `${STORAGE_SERVER_URL}/api/scenes/${encodeURIComponent(roomId)}`,
  );
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(
      `Failed to load scene (${response.status} ${response.statusText})`,
    );
  }
  return (await response.json()) as LocalStoredScene;
};

const persistLocalSceneDocument = async (
  roomId: string,
  document: LocalStoredScene,
) => {
  if (!STORAGE_SERVER_URL) {
    return;
  }
  const response = await fetch(
    `${STORAGE_SERVER_URL}/api/scenes/${encodeURIComponent(roomId)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(document),
    },
  );

  if (!response.ok && response.status !== 204) {
    throw new Error(
      `Failed to persist scene (${response.status} ${response.statusText})`,
    );
  }
};

class FirebaseSceneVersionCache {
  private static cache = new WeakMap<Socket, number>();
  static get = (socket: Socket) => {
    return FirebaseSceneVersionCache.cache.get(socket);
  };
  static set = (
    socket: Socket,
    elements: readonly SyncableExcalidrawElement[],
  ) => {
    FirebaseSceneVersionCache.cache.set(socket, getSceneVersion(elements));
  };
}

export const isSavedToFirebase = (
  portal: Portal,
  elements: readonly ExcalidrawElement[],
): boolean => {
  if (portal.socket && portal.roomId && portal.roomKey) {
    const sceneVersion = getSceneVersion(elements);

    return FirebaseSceneVersionCache.get(portal.socket) === sceneVersion;
  }
  // if no room exists, consider the room saved so that we don't unnecessarily
  // prevent unload (there's nothing we could do at that point anyway)
  return true;
};

export const saveFilesToFirebase = async ({
  prefix,
  files,
}: {
  prefix: string;
  files: { id: FileId; buffer: Uint8Array }[];
}) => {
  if (!isFirebaseConfigured) {
    if (!STORAGE_SERVER_URL) {
      return {
        savedFiles: [] as FileId[],
        erroredFiles: files.map((file) => file.id),
      };
    }

    const response = await fetch(`${STORAGE_SERVER_URL}/api/files`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prefix,
        files: files.map(({ id, buffer }) => ({
          id,
          buffer: uint8ArrayToBase64(
            buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer),
          ),
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to persist files (${response.status} ${response.statusText})`,
      );
    }

    const result = (await response.json()) as {
      savedFiles?: FileId[];
      erroredFiles?: FileId[];
    };

    return {
      savedFiles: result.savedFiles ?? [],
      erroredFiles: result.erroredFiles ?? [],
    };
  }

  const storage = await loadFirebaseStorage();
  if (!storage) {
    return {
      savedFiles: [] as FileId[],
      erroredFiles: files.map((file) => file.id),
    };
  }

  const erroredFiles: FileId[] = [];
  const savedFiles: FileId[] = [];

  await Promise.all(
    files.map(async ({ id, buffer }) => {
      try {
        const storageRef = ref(storage, `${prefix}/${id}`);
        await uploadBytes(storageRef, buffer, {
          cacheControl: `public, max-age=${FILE_CACHE_MAX_AGE_SEC}`,
        });
        savedFiles.push(id);
      } catch (error: any) {
        erroredFiles.push(id);
      }
    }),
  );

  return { savedFiles, erroredFiles };
};

const createFirebaseSceneDocument = async (
  elements: readonly SyncableExcalidrawElement[],
  roomKey: string,
) => {
  const sceneVersion = getSceneVersion(elements);
  const { ciphertext, iv } = await encryptElements(roomKey, elements);
  return {
    sceneVersion,
    ciphertext: Bytes.fromUint8Array(new Uint8Array(ciphertext)),
    iv: Bytes.fromUint8Array(iv),
  } as FirebaseStoredScene;
};

export const saveToFirebase = async (
  portal: Portal,
  elements: readonly SyncableExcalidrawElement[],
  appState: AppState,
) => {
  if (!isFirebaseConfigured) {
    const { roomId, roomKey, socket } = portal;
    if (
      !roomId ||
      !roomKey ||
      !socket ||
      isSavedToFirebase(portal, elements) ||
      !STORAGE_SERVER_URL
    ) {
      if (socket) {
        FirebaseSceneVersionCache.set(socket, elements);
      }
      return null;
    }

    let reconciledElements = getSyncableElements(elements);

    const existingDocument = await fetchLocalSceneDocument(roomId);
    if (existingDocument) {
      const remoteElements = getSyncableElements(
        restoreElements(
          await decryptLocalScene(existingDocument, roomKey),
          null,
        ),
      );
      reconciledElements = getSyncableElements(
        reconcileElements(
          elements,
          remoteElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
          appState,
        ),
      );
    }

    const document = await createLocalSceneDocument(
      reconciledElements,
      roomKey,
    );
    await persistLocalSceneDocument(roomId, document);
    FirebaseSceneVersionCache.set(socket, reconciledElements);
    return reconciledElements;
  }

  const { roomId, roomKey, socket } = portal;
  if (
    // bail if no room exists as there's nothing we can do at this point
    !roomId ||
    !roomKey ||
    !socket ||
    isSavedToFirebase(portal, elements)
  ) {
    return null;
  }

  const firestore = _getFirestore();
  if (!firestore) {
    return null;
  }
  const docRef = doc(firestore, "scenes", roomId);

  const storedScene = await runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(docRef);

    if (!snapshot.exists()) {
      const storedScene = await createFirebaseSceneDocument(elements, roomKey);

      transaction.set(docRef, storedScene);

      return storedScene;
    }

    const prevStoredScene = snapshot.data() as FirebaseStoredScene;
    const prevStoredElements = getSyncableElements(
      restoreElements(await decryptElements(prevStoredScene, roomKey), null),
    );
    const reconciledElements = getSyncableElements(
      reconcileElements(
        elements,
        prevStoredElements as OrderedExcalidrawElement[] as RemoteExcalidrawElement[],
        appState,
      ),
    );

    const storedScene = await createFirebaseSceneDocument(
      reconciledElements,
      roomKey,
    );

    transaction.update(docRef, storedScene);

    // Return the stored elements as the in memory `reconciledElements` could have mutated in the meantime
    return storedScene;
  });

  const storedElements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null),
  );

  FirebaseSceneVersionCache.set(socket, storedElements);

  return storedElements;
};

export const loadFromFirebase = async (
  roomId: string,
  roomKey: string,
  socket: Socket | null,
): Promise<readonly SyncableExcalidrawElement[] | null> => {
  if (!isFirebaseConfigured) {
    if (!STORAGE_SERVER_URL) {
      return null;
    }
    const storedScene = await fetchLocalSceneDocument(roomId);
    if (!storedScene) {
      return null;
    }
    const elements = getSyncableElements(
      restoreElements(await decryptLocalScene(storedScene, roomKey), null, {
        deleteInvisibleElements: true,
      }),
    );

    if (socket) {
      FirebaseSceneVersionCache.set(socket, elements);
    }

    return elements;
  }

  const firestore = _getFirestore();
  if (!firestore) {
    return null;
  }
  const docRef = doc(firestore, "scenes", roomId);
  const docSnap = await getDoc(docRef);
  if (!docSnap.exists()) {
    return null;
  }
  const storedScene = docSnap.data() as FirebaseStoredScene;
  const elements = getSyncableElements(
    restoreElements(await decryptElements(storedScene, roomKey), null, {
      deleteInvisibleElements: true,
    }),
  );

  if (socket) {
    FirebaseSceneVersionCache.set(socket, elements);
  }

  return elements;
};

export const loadFilesFromFirebase = async (
  prefix: string,
  decryptionKey: string,
  filesIds: readonly FileId[],
) => {
  if (!isFirebaseConfigured) {
    if (!STORAGE_SERVER_URL) {
      return {
        loadedFiles: [] as BinaryFileData[],
        erroredFiles: Array.from(new Set(filesIds)).reduce((acc, fileId) => {
          acc.set(fileId, true);
          return acc;
        }, new Map<FileId, true>()),
      };
    }

    const loadedFiles: BinaryFileData[] = [];
    const erroredFiles = new Map<FileId, true>();

    await Promise.all(
      [...new Set(filesIds)].map(async (id) => {
        try {
          const response = await fetch(
            `${STORAGE_SERVER_URL}/api/files?prefix=${encodeURIComponent(
              prefix,
            )}&id=${encodeURIComponent(id)}`,
          );
          if (response.status === 404) {
            erroredFiles.set(id, true);
            return;
          }
          if (!response.ok) {
            throw new Error(
              `Failed to load file (${response.status} ${response.statusText})`,
            );
          }
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } catch (error: any) {
          erroredFiles.set(id, true);
          console.error(error);
        }
      }),
    );

    return { loadedFiles, erroredFiles };
  }

  const loadedFiles: BinaryFileData[] = [];
  const erroredFiles = new Map<FileId, true>();

  await Promise.all(
    [...new Set(filesIds)].map(async (id) => {
      try {
        const url = `https://firebasestorage.googleapis.com/v0/b/${
          FIREBASE_CONFIG.storageBucket
        }/o/${encodeURIComponent(prefix.replace(/^\//, ""))}%2F${id}`;
        const response = await fetch(`${url}?alt=media`);
        if (response.status < 400) {
          const arrayBuffer = await response.arrayBuffer();

          const { data, metadata } = await decompressData<BinaryFileMetadata>(
            new Uint8Array(arrayBuffer),
            {
              decryptionKey,
            },
          );

          const dataURL = new TextDecoder().decode(data) as DataURL;

          loadedFiles.push({
            mimeType: metadata.mimeType || MIME_TYPES.binary,
            id,
            dataURL,
            created: metadata?.created || Date.now(),
            lastRetrieved: metadata?.created || Date.now(),
          });
        } else {
          erroredFiles.set(id, true);
        }
      } catch (error: any) {
        erroredFiles.set(id, true);
        console.error(error);
      }
    }),
  );

  return { loadedFiles, erroredFiles };
};
