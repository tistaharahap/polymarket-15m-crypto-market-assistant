import "./globals.css";
import { IBM_Plex_Sans, DM_Serif_Display } from "next/font/google";

const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body"
});

const display = DM_Serif_Display({
  subsets: ["latin"],
  weight: ["400"],
  variable: "--font-display"
});

export const metadata = {
  title: "BTC 15m Assistant",
  description: "A web UI for the Polymarket BTC 15m assistant"
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable}`}>
      <body>
        {children}
      </body>
    </html>
  );
}
