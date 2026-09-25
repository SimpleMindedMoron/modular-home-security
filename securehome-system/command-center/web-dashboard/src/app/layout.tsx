import type { Metadata } from 'next';
import { Space_Grotesk, DM_Mono } from 'next/font/google';
import './globals.css';
import { AuthProvider } from '../context/AuthContext';

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600', '700'],
  display: 'swap',
  variable: '--font-sans',
});

const dmMono = DM_Mono({
  subsets: ['latin'],
  weight: ['300', '400', '500'],
  display: 'swap',
  variable: '--font-mono',
});

export const metadata: Metadata = {
  title: 'SecureHome | Security Command Center',
  description: 'Centralized ESP32 Smart Security Management and Telemetry Dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${dmMono.variable}`}>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
