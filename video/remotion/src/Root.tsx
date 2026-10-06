import { Composition } from "remotion";
import { Story } from "./Story";
import { END, FPS } from "./data";

export const Root = () => (
  <Composition id="Story" component={Story} durationInFrames={Math.round(END * FPS)} fps={FPS} width={1920} height={1080} />
);
