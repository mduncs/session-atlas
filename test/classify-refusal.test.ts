import { expect, test } from "bun:test";
import { isRefusal } from "../src/classify.js";

test("topic lines that merely mention law, terms, or regulations are not refusals", () => {
  for (const text of [
    '{"topic_line":"clawd-fable launcher flaws, lawn sensor, Kirchhoff laws","tags":["atlas"]}',
    '{"topic_line":"Terms of service review for the ledger app","tags":["legal"]}',
    '{"topic_line":"EU battery regulations summary","tags":["policy"]}',
  ]) expect(isRefusal(text)).toEqual({ refusal: false });
});

test("an actual policy refusal is still caught", () => {
  expect(isRefusal("Summarizing this would violate applicable laws.").refusal).toBe(true);
  expect(isRefusal("This request violates the terms I operate under.").refusal).toBe(true);
  expect(isRefusal("Sharing that breaches applicable regulations.").refusal).toBe(true);
  expect(isRefusal("I'm sorry, but I can't help with that.").refusal).toBe(true);
});
