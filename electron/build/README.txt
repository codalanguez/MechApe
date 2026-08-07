App icon assets — used by the desktop window, taskbar, splash screen, the
NSIS installer, and the macOS/Linux packages.

  icon-source.png   master artwork (MechApe ape with cyan glasses, 1080px)
  icon.png          256px render — splash screen, generic fallback
  icon.ico          multi-size Windows icon (16/24/32/48/64/128/256)
  icon.icns         macOS icon (package.json build.mac.icon)
  icons/            Linux AppImage icon set (package.json build.linux.icon),
                    16/24/32/48/64/128/256/512/1024 px

The web UI's own copy lives at public/icon.png (512px) — favicon, brand mark,
and welcome-screen ember. The artwork carries the wordmark, so it turns to
mush below ~32px; that has been true of every version of this icon. If the
16px taskbar render ever needs to be legible, crop a face-only variant rather
than shrinking this one further.

To regenerate after changing icon-source.png (Python + Pillow — no Node
dependency, since nothing else in the build needs an image library):

  from PIL import Image
  src = Image.open('electron/build/icon-source.png').convert('RGBA')
  r = lambda px: src.resize((px, px), Image.LANCZOS)

  r(256).save('electron/build/icon.png')
  r(256).save('electron/build/icon.ico', format='ICO',
              sizes=[(s, s) for s in (16, 24, 32, 48, 64, 128, 256)])
  r(1024).save('electron/build/icon.icns', format='ICNS')
  for s in (16, 24, 32, 48, 64, 128, 256, 512, 1024):
      r(s).save(f'electron/build/icons/{s}x{s}.png')
  r(512).save('public/icon.png')

Pillow writes the modern PNG-based ICNS chunk types (ic07-ic14), which macOS
10.7+ reads; it does not need iconutil or a Mac to run.
