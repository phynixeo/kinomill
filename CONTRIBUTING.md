# Contributing to Kinomill

Thanks for helping! Kinomill is a Windows app built with Electron, React and TypeScript.

## Set up

```bash
git clone https://github.com/phynixeo/kinomill.git
cd kinomill
npm ci
npm run app
```

`npm run browser` serves the full app at http://127.0.0.1:5199, which is handy for UI work.

## Before you open a pull request

- `npm run typecheck` passes.
- `npm run build` passes.
- If you changed a download, convert, disc or audio engine, `npm test` passes (it needs FFmpeg).
- One topic per pull request. Describe what changed and how you tested it, and add a screenshot for UI changes.
- Keep the code style of the file you edit. User-facing text is plain, friendly English.

## What we won't merge

- Anything that bypasses DRM (Netflix, Spotify, Widevine and the like).
- Copyrighted media in tests or screenshots. Use public-domain or Creative Commons material, such as the Blender open movies.
- Telemetry or analytics, or bundled ads and "offers".

## Reporting bugs

Use the bug report form. Never paste cookies, `cookies.txt` contents or private links into issues.
If a site stopped working, first update yt-dlp in **Settings → Components**.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
