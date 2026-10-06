import { loadFont as loadAnton } from "@remotion/google-fonts/Anton";
import { loadFont as loadBarlow } from "@remotion/google-fonts/Barlow";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { Easing } from "remotion";

// The app's brand tokens (src/app/globals.css, dark theme).
export const C = {
  bg: "#0b0b0f", surface: "#16161d", surface2: "#1f1f29", line: "#2c2c38", ink: "#f4f1ea", muted: "#a7a2b0",
  accent: "#ff6b1a", neon: "#ff2e88", qloo: "#4fe3a5", ai: "#c3b3ff", sample: "#ffc861",
};
export const display = loadAnton("normal", { weights: ["400"], subsets: ["latin"] }).fontFamily;
export const sans = loadBarlow("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] }).fontFamily;
export const mono = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

export const ease = Easing.bezier(0.2, 0.8, 0.2, 1);
export const PIC_H = 990; // picture area; the caption band is the 90 px below it
