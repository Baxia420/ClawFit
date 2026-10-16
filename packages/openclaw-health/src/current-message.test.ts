import { expect, it } from "vitest";
import { isCheckIn } from "./current-message.js";

it.each(["@Clawfit are you okay?", "are you there", "hey, are u working?", "@60123456789 are you alive?"])("recognizes a standalone check-in: %s", text => {
  expect(isCheckIn(text)).toBe(true);
});

it.each(["are you okay? Estimate one egg", "Log my sandwich", "Are you working on my meal?", "okay", "Is this food okay?"])("does not swallow a meal or other request: %s", text => {
  expect(isCheckIn(text)).toBe(false);
});
