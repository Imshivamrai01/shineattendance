export default function manifest() {
  return {
    name: 'Shine Attendance',
    short_name: 'Shine',
    description: 'Shine Infosolutions attendance and workforce app',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#ffffff', // Android splash background
    theme_color: '#4257e6',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'Attendance', url: '/attendance', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Requests', url: '/requests', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  };
}
