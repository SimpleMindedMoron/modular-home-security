import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SecureHome Command Center',
  description: 'Centralized ESP32 Smart Security Management Dashboard',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
