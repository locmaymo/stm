# Docker and ModelScope

Build and run with a durable volume:

```text
docker build -f deploy/docker/Dockerfile -t sillytavern-manager .
docker run --rm -p 7860:7860 -v sillytavern-manager-data:/data -e STM_ADMIN_PASSWORD="change-this-secret" sillytavern-manager
```

The manager is exposed on port `7860`; SillyTavern stays on its internal `8000` port and a configured tunnel points only to that port. On hosted container studios, mount durable storage at `/mnt/workspace`; the manager detects that location automatically. Provide `STM_ADMIN_PASSWORD` through the platform secret instead of putting it in an image.
