# Local SearXNG

This folder keeps the local SearXNG setup used by the chatbot.
The checked-in config lives in `core-config/settings.yml`. It is tuned for the bot use case:

- JSON responses are enabled for `/search?format=json`.
- Limiter and image proxy are disabled for local use.
- Cache data is stored in `./data`.

## Windows Development

Use the chatbot workspace scripts:

```powershell
npm run search
npm run chat
```

`run-dev.ps1` downloads a source archive from the official `searxng/searxng` repository, extracts only Windows-safe paths, patches one upstream `pwd` import that breaks native Windows startup, creates a local virtualenv, and starts `python -m searx.webapp` on `http://127.0.0.1:8891`.

The first run takes longer because it installs Python dependencies into `./.venv`.
