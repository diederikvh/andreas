# Andreas — splash assets

Twee varianten:
- `splash/nacht/` — zwart met acid kruis (default)
- `splash/dag/`   — ecru met rood kruis

## Per variant

| Bestand | Maat | Wanneer |
|---|---|---|
| `splash.png` | 1242×2436 | Klassieke fullscreen splash (resizeMode: cover) |
| `splash-square.png` | 2048×2048 | Vierkante variant voor tablet of fallback |
| `splash-icon.png` | 1024×1024 (transparant) | Voor de moderne Expo splash-screen plugin (Android 12+) |
| `splash.svg` / `splash-icon.svg` | vector | Master, voor toekomstige aanpassingen |

## Wiring (Expo SDK 50+)

```json
{
  "expo": {
    "plugins": [
      [
        "expo-splash-screen",
        {
          "image": "./splash/nacht/splash-icon.png",
          "imageWidth": 200,
          "backgroundColor": "#0a0a0b",
          "dark": {
            "image": "./splash/nacht/splash-icon.png",
            "backgroundColor": "#0a0a0b"
          }
        }
      ]
    ]
  }
}
```

Wil je de **dag-variant** als default? Vervang `./splash/nacht/splash-icon.png` door `./splash/dag/splash-icon.png` en `backgroundColor` door `#d9d1bf`.

## Klassieke (legacy) splash config

```json
"splash": {
  "image": "./splash/nacht/splash.png",
  "resizeMode": "cover",
  "backgroundColor": "#0a0a0b"
}
```
