import './globals.css';
import Pwa from '@/components/Pwa';
import splash from '@/lib/splash.json';

export const metadata = {
  title: 'Shine Attendance',
  description: 'Workforce attendance and HR platform',
  applicationName: 'Shine Attendance',
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [{ url: '/icons/favicon-32.png', sizes: '32x32', type: 'image/png' }, { url: '/icons/favicon-16.png', sizes: '16x16', type: 'image/png' }],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  appleWebApp: { capable: true, title: 'Shine', statusBarStyle: 'default', startupImage: splash },
  formatDetection: { telephone: false },
};
export const viewport = {
  width: 'device-width', initialScale: 1, viewportFit: 'cover', themeColor: '#4257e6',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Pwa />
      </body>
    </html>
  );
}
