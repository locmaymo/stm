# Third-party notices

The files under `packages/ui/src/shadcn/` are adapted from shadcn/ui registry blocks and components, licensed under the MIT License.

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, subject to including this notice in copies or substantial portions of the Software.

The manager bundles `qrcode-generator`, licensed under the MIT License. The
panel draws the code shown on the access card with it, and the server draws the
one printed in the terminal at startup.

Copyright (c) 2009 Kazuhiko Arase

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, subject to including this notice in copies or substantial portions of the Software.

"QR Code" is a registered trademark of DENSO WAVE INCORPORATED.

## Bundled in the Windows download

The Windows download carries four programs, unmodified, under `resources/`,
so that installing SillyTavern and opening a link need nothing else on the
machine:

- `resources/runtime/node.exe` is Node.js, licensed under the MIT License
  (<https://github.com/nodejs/node/blob/main/LICENSE>).
- `resources/runtime/node_modules/npm` is npm, licensed under the Artistic
  License 2.0; its license is in that directory.
- `resources/git` is MinGit from Git for Windows, licensed under the GNU
  General Public License version 2, with the licenses of its components in
  `resources/git/usr/share/licenses` and `resources/git/mingw64/share/licenses`.
  The complete corresponding source for the exact build shipped
  is published with its release:
  <https://github.com/git-for-windows/git/releases/tag/v2.55.0.windows.5>.
  The version is pinned in `scripts/build-windows-release.mjs`, and this link
  changes with it.
- `resources/bin/cloudflared.exe` is cloudflared from Cloudflare, licensed
  under the Apache License 2.0
  (<https://github.com/cloudflare/cloudflared/blob/master/LICENSE>). The
  version is pinned in the same script. When it grows old the manager fetches
  the current release from the same project into its data folder.

## Bundled in the Android app

The Android app carries Termux's Android builds of Node.js, Git, cloudflared
and the libraries they load, plus npm from its registry, unmodified. The exact
packages, versions and SHA-256 digests are listed in
`packaging/android/runtime-packages.json`.

- Node.js is licensed under the MIT License, npm under the Artistic License 2.0,
  and cloudflared under the Apache License 2.0.
- Git is licensed under the GNU General Public License version 2, and libiconv
  under the GNU Lesser General Public License version 2.1. The other libraries
  are under their own permissive licenses: OpenSSL and libc++ (Apache 2.0),
  ICU (Unicode License), curl, zlib, c-ares, expat, nghttp2, nghttp3, ngtcp2,
  libssh2, PCRE2 and SQLite (each under its own terms), and the Mozilla CA
  certificate bundle (MPL 2.0).
- Each package's copyright file and the license texts it refers to are
  installed with it, under `share/doc/<package>/copyright` and
  `share/LICENSES/` in the app's runtime directory.
- The build recipes are published by the Termux project at
  <https://github.com/termux/termux-packages>, and each recipe names the
  upstream source release it builds; that is the corresponding source for the
  binaries shipped.
- The app itself is built with AndroidX WebKit 1.8.0 and the AndroidX
  libraries it depends on (Core, Annotation, Collection, Lifecycle, Arch Core
  and VersionedParcelable), from the Android Open Source Project under the
  Apache License 2.0. They let SillyTavern's page tell the app when a
  character has replied, for chat bubbles.

## Trademarks and artwork

The application icon, favicon, and in-application brand mark under
`apps/manager-panel/public/` are resized from the SillyTavern Vietnam (STVN)
logo, used with permission as this project's own mark.
`scripts/build-brand-assets.mjs` produces them from the source artwork.

`packages/ui/src/brand.tsx` contains simplified redrawings of the Cloudflare,
Cloudflare R2, Docker, and GitHub logos. They are used only to identify those
services where the manager integrates with them. Cloudflare and the Cloudflare
logo are trademarks of Cloudflare, Inc.; Docker and the Docker logo are
trademarks of Docker, Inc.; GitHub and the GitHub logo are trademarks of
GitHub, Inc. No endorsement or affiliation is claimed.

## The promo video

The promo animation under `promo/` uses these works:

- `promo/assets/st/seraphina.jpg`, `promo/assets/st/user.png` and
  `promo/assets/st/tavern-day.jpg` are resized from the default character
  avatar, the default user avatar and the "tavern day" background that ship
  with SillyTavern (<https://github.com/SillyTavern/SillyTavern>), under the
  GNU Affero General Public License version 3.0.
- `promo/assets/st/wikipe-tan.jpg` is cropped from "Wikipe-tan full length"
  by Kasuga and contributors, from Wikimedia Commons, under the Creative
  Commons Attribution-ShareAlike 3.0 license
  (<https://creativecommons.org/licenses/by-sa/3.0/>). The crop is shared
  under the same license.
- Be Vietnam Pro and JetBrains Mono in `promo/assets/fonts/` are under the SIL
  Open Font License 1.1; the license texts sit next to the fonts.
- The operating system marks in `promo/index.html` come from Simple Icons
  (<https://simpleicons.org>), under CC0 1.0. Windows is a trademark of
  Microsoft Corporation; Android is a trademark of Google LLC; macOS is a
  trademark of Apple Inc.; Linux is a trademark of Linus Torvalds; Docker is a
  trademark of Docker, Inc. They identify the systems STM runs on; no
  endorsement or affiliation is claimed.
