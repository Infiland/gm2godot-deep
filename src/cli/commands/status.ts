import type { CommandRunner } from "../main.ts";
import { DeepError } from "../../util/result.ts";

export const run: CommandRunner = () => {
  throw new DeepError("GM2DEEP-NOT-IMPLEMENTED", "command status is not implemented yet");
};
