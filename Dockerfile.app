# Production Dockerfile for StoryBored (using pre-built files)

FROM node:22-alpine

WORKDIR /app

# Install http-server globally
RUN npm install -g http-server

# Copy pre-built files
COPY excalidraw-app/build ./build

# Expose port
EXPOSE 3200

# Start http-server
CMD ["http-server", "build", "-p", "3200", "--cors", "-c-1"]
