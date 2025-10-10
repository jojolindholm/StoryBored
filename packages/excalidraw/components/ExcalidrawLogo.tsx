import "./ExcalidrawLogo.scss";

import brandLogo from "./assets/brand-logo.svg";
import brandMark from "./assets/brand-mark.svg";

type LogoSize = "tiny" | "small" | "default" | "large";

type LogoProps = {
  style?: React.CSSProperties;
  size?: LogoSize;
  withText?: boolean;
  alt?: string;
};

const LogoImage = ({
  src,
  className,
  alt,
}: {
  src: string;
  className: string;
  alt: string;
}) => (
  <img
    src={src}
    className={className}
    alt={alt}
    draggable={false}
    loading="lazy"
  />
);

export const ExcalidrawLogo = ({
  style,
  size = "small",
  withText,
  alt = "Storyboard",
}: LogoProps) => {
  return (
    <div className={`ExcalidrawLogo is-${size}`} style={style}>
      {withText ? (
        <LogoImage
          src={brandLogo}
          className="ExcalidrawLogo-combined"
          alt={alt}
        />
      ) : (
        <LogoImage
          src={brandMark}
          className="ExcalidrawLogo-mark"
          alt={alt}
        />
      )}
    </div>
  );
};

export default ExcalidrawLogo;
