# StoryBored Docker Setup

This guide explains how to run StoryBored (Excalidraw) using Docker.

## Prerequisites

- Docker installed
- Docker Compose installed

## Quick Start

### 1. Build and Start

```bash
# Build and start both services
docker-compose up -d

# View logs
docker-compose logs -f
```

### 2. Access the Application

- **Main App:** http://localhost:3200
- **Collaboration Server:** http://localhost:3002

### 3. Stop Services

```bash
docker-compose down
```

## Configuration

### Environment Variables

Edit `docker-compose.yml` to customize:

**App Service:**
- Port mapping (default: 3200)

**Collaboration Service:**
- `PORT`: Server port (default: 3002)
- `CORS_ORIGIN`: Allowed origins (comma-separated)
- `COLLAB_DATA_DIR`: Data directory path
- `MAX_JSON_PAYLOAD`: Max payload size

### Example CORS Configuration

```yaml
environment:
  - CORS_ORIGIN=https://storybored.johanlindholm.com,https://johanlindholm.com,http://localhost:3200
```

## Data Persistence

Collaboration data is stored in a Docker volume named `collab-data`. This persists:
- Collaboration sessions
- Uploaded files
- Scene data

To back up:
```bash
docker run --rm -v storybored_collab-data:/data -v $(pwd):/backup alpine tar czf /backup/collab-backup.tar.gz /data
```

To restore:
```bash
docker run --rm -v storybored_collab-data:/data -v $(pwd):/backup alpine tar xzf /backup/collab-backup.tar.gz -C /
```

## Updating

### Rebuild After Code Changes

```bash
# Rebuild and restart
docker-compose up -d --build

# Or rebuild specific service
docker-compose up -d --build storybored-app
```

### Update CORS or Environment Variables

1. Edit `docker-compose.yml`
2. Restart services:
```bash
docker-compose up -d
```

## Production Deployment

### With Nginx Reverse Proxy

Example nginx configuration:

```nginx
# Main app
server {
    listen 443 ssl http2;
    server_name storybored.johanlindholm.com;
    
    # SSL configuration here...
    
    location / {
        proxy_pass http://localhost:3200;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Collaboration server
server {
    listen 443 ssl http2;
    server_name collab.johanlindholm.com;
    
    # SSL configuration here...
    
    location / {
        proxy_pass http://localhost:3002;
        proxy_http_version 1.1;
        
        # WebSocket support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### Resource Limits (Optional)

Add to `docker-compose.yml`:

```yaml
services:
  storybored-app:
    # ... existing config ...
    deploy:
      resources:
        limits:
          cpus: '1.0'
          memory: 512M
        reservations:
          cpus: '0.5'
          memory: 256M
```

## Troubleshooting

### View Logs

```bash
# All services
docker-compose logs -f

# Specific service
docker-compose logs -f storybored-app
docker-compose logs -f storybored-collab
```

### Check Running Containers

```bash
docker-compose ps
```

### Restart Services

```bash
docker-compose restart
```

### Clean Rebuild

```bash
# Stop and remove containers
docker-compose down

# Remove images
docker-compose down --rmi all

# Rebuild from scratch
docker-compose up -d --build
```

## Development vs Production

This Docker setup is configured for **production use** with:
- ✅ Optimized production builds
- ✅ Multi-stage builds (smaller images)
- ✅ Persistent data volumes
- ✅ Automatic restarts
- ✅ CORS configured

For local development, you may prefer running:
```bash
# Development mode (hot reload)
cd excalidraw-app
npx vite --port 3200 --host
```

## Port Reference

| Service | Internal Port | External Port | Purpose |
|---------|--------------|---------------|---------|
| Main App | 3200 | 3200 | Excalidraw UI |
| Collab Server | 3002 | 3002 | WebSocket + API |


