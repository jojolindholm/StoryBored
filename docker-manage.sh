#!/bin/bash

# StoryBored Docker Management Script

set -e

case "$1" in
  start)
    echo "🚀 Starting StoryBored services..."
    docker-compose up -d
    echo "✅ Services started!"
    echo "   Main App: http://localhost:3200"
    echo "   Collab Server: http://localhost:3002"
    ;;
    
  stop)
    echo "🛑 Stopping StoryBored services..."
    docker-compose down
    echo "✅ Services stopped!"
    ;;
    
  restart)
    echo "🔄 Restarting StoryBored services..."
    docker-compose restart
    echo "✅ Services restarted!"
    ;;
    
  rebuild)
    echo "🔨 Rebuilding and restarting services..."
    docker-compose up -d --build
    echo "✅ Services rebuilt and started!"
    ;;
    
  logs)
    echo "📋 Showing logs (Ctrl+C to exit)..."
    docker-compose logs -f
    ;;
    
  logs-app)
    echo "📋 Showing app logs (Ctrl+C to exit)..."
    docker-compose logs -f storybored-app
    ;;
    
  logs-collab)
    echo "📋 Showing collab server logs (Ctrl+C to exit)..."
    docker-compose logs -f storybored-collab
    ;;
    
  status)
    echo "📊 Service status:"
    docker-compose ps
    ;;
    
  clean)
    echo "🧹 Cleaning up (keeping data)..."
    docker-compose down
    docker-compose down --rmi all
    echo "✅ Cleanup complete!"
    ;;
    
  backup)
    BACKUP_FILE="collab-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    echo "💾 Backing up collaboration data to $BACKUP_FILE..."
    docker run --rm -v storybored_collab-data:/data -v $(pwd):/backup alpine tar czf /backup/$BACKUP_FILE -C /data .
    echo "✅ Backup saved: $BACKUP_FILE"
    ;;
    
  restore)
    if [ -z "$2" ]; then
      echo "❌ Error: Please specify backup file"
      echo "Usage: $0 restore <backup-file>"
      exit 1
    fi
    echo "📦 Restoring collaboration data from $2..."
    docker run --rm -v storybored_collab-data:/data -v $(pwd):/backup alpine tar xzf /backup/$2 -C /data
    echo "✅ Restore complete!"
    ;;
    
  *)
    echo "StoryBored Docker Management"
    echo ""
    echo "Usage: $0 {command}"
    echo ""
    echo "Commands:"
    echo "  start         Start all services"
    echo "  stop          Stop all services"
    echo "  restart       Restart all services"
    echo "  rebuild       Rebuild and restart services"
    echo "  logs          Show all logs"
    echo "  logs-app      Show app logs only"
    echo "  logs-collab   Show collab server logs only"
    echo "  status        Show service status"
    echo "  clean         Stop and remove containers/images"
    echo "  backup        Backup collaboration data"
    echo "  restore FILE  Restore collaboration data from backup"
    echo ""
    exit 1
    ;;
esac

