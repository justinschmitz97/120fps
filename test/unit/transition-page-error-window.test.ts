import { describe, it, expect } from "vitest";
import { runWithSplitErrorWindows, nextComboIndex, type RerenderResult } from "../../src/measure.js";
import type { PageErrorDrain } from "../../src/page-errors.js";

// The rerender pass mounts combo `ci`'s props and then rerenders into
// `combos[ci+1]`'s props. A single error window over both made every error the
// next combo's props raised look like combo `ci`'s own (V1, radix Label #1/#6).
// These tests drive the sequencing directly with a fake page-error buffer.

function createFakeCapture() {
  let buffer: string[] = [];
  return {
    raise(message: string) {
      buffer.push(message);
    },
    drain(): PageErrorDrain {
      const messages = buffer;
      buffer = [];
      return { messages, fatal: false, dropped: 0 };
    },
  };
}

function comboResult(comboIndex: number): RerenderResult {
  return {
    comboIndex,
    props: { asChild: undefined },
    stable: { samples: [1], median: 1, p95: 1 },
  };
}

describe("page errors around a prop-change rerender", () => {
  it("attributes an error raised by the transition to the transition, not to the combo", async () => {
    const capture = createFakeCapture();
    const result = comboResult(1);

    const returned = await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 2,
      run: async () => {
        capture.raise("Primitive.label failed to slot onto its children.");
      },
    });

    expect(returned.pageErrors).toBeUndefined();
    expect(returned.transitionPageErrors).toEqual({
      toComboIndex: 2,
      errors: { messages: ["Primitive.label failed to slot onto its children."], fatal: false, dropped: 0 },
    });
  });

  it("keeps an error raised before the transition on the combo's own window", async () => {
    const capture = createFakeCapture();
    capture.raise("own render threw");
    const result = comboResult(0);

    await runWithSplitErrorWindows(capture, result, { toComboIndex: 1, run: async () => {} });

    expect(result.pageErrors?.messages).toEqual(["own render threw"]);
    expect(result.transitionPageErrors).toBeUndefined();
  });

  it("splits a combo that raises in both windows into two separately attributed drains", async () => {
    const capture = createFakeCapture();
    capture.raise("own render threw");
    const result = comboResult(3);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 4,
      run: async () => {
        capture.raise("transition threw");
      },
    });

    expect(result.pageErrors?.messages).toEqual(["own render threw"]);
    expect(result.transitionPageErrors?.errors.messages).toEqual(["transition threw"]);
  });

  it("closes the combo's own window before the transition runs", async () => {
    const capture = createFakeCapture();
    capture.raise("own render threw");
    const result = comboResult(0);
    let seenDuringTransition: string[] | undefined;

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 1,
      run: async () => {
        capture.raise("transition threw");
        seenDuringTransition = capture.drain().messages;
        for (const message of seenDuringTransition) capture.raise(message);
      },
    });

    expect(seenDuringTransition).toEqual(["transition threw"]);
  });

  it("records the combo's own errors when there is no transition to run", async () => {
    const capture = createFakeCapture();
    capture.raise("own render threw");
    const result = comboResult(7);

    await runWithSplitErrorWindows(capture, result, undefined);

    expect(result.pageErrors?.messages).toEqual(["own render threw"]);
    expect(result.transitionPageErrors).toBeUndefined();
  });

  it("attributes a transition error even when every change sample was omitted", async () => {
    const capture = createFakeCapture();
    const result = comboResult(2);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 3,
      run: async () => {
        capture.raise("transition threw");
      },
    });

    expect(result.change).toBeUndefined();
    expect(result.transitionPageErrors?.toComboIndex).toBe(3);
  });

  it("attaches nothing when neither window recorded an error", async () => {
    const capture = createFakeCapture();
    const result = comboResult(0);

    await runWithSplitErrorWindows(capture, result, { toComboIndex: 1, run: async () => {} });

    expect(result.pageErrors).toBeUndefined();
    expect(result.transitionPageErrors).toBeUndefined();
  });

  it("keeps a drain that only dropped messages, matching hasPageErrors", async () => {
    const result = comboResult(0);
    let call = 0;
    const capture = {
      drain(): PageErrorDrain {
        call++;
        return call === 1
          ? { messages: [], fatal: false, dropped: 3 }
          : { messages: [], fatal: false, dropped: 2 };
      },
    };

    await runWithSplitErrorWindows(capture, result, { toComboIndex: 1, run: async () => {} });

    expect(result.pageErrors?.dropped).toBe(3);
    expect(result.transitionPageErrors?.errors.dropped).toBe(2);
  });
});

// Review B-6: the prop-change loop mounts combo `ci`'s OWN props before each
// rerender into the next combo's, and every error those mounts raised was
// attributed to the transition — which M99 excludes from the verdict. M99's
// MUST NOT is "move an error to a different combo's verdict".

describe("the mounts the prop-change loop performs with the combo's own props", () => {
  it("keeps an own-props mount error on the combo, not on the transition", async () => {
    const capture = createFakeCapture();
    const result = comboResult(2);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 3,
      run: async (claimOwnWindow) => {
        capture.raise("own mount threw");
        claimOwnWindow();
      },
    });

    expect(result.pageErrors?.messages).toEqual(["own mount threw"]);
    expect(result.transitionPageErrors).toBeUndefined();
  });

  it("splits a loop that throws on both the mount and the rerender", async () => {
    const capture = createFakeCapture();
    const result = comboResult(2);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 3,
      run: async (claimOwnWindow) => {
        capture.raise("own mount threw");
        claimOwnWindow();
        capture.raise("transition threw");
      },
    });

    expect(result.pageErrors?.messages).toEqual(["own mount threw"]);
    expect(result.transitionPageErrors?.errors.messages).toEqual(["transition threw"]);
  });

  it("merges an own-props mount error with what the stable samples raised", async () => {
    const capture = createFakeCapture();
    capture.raise("stable threw");
    const result = comboResult(1);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 2,
      run: async (claimOwnWindow) => {
        capture.raise("own mount threw");
        claimOwnWindow();
      },
    });

    expect(result.pageErrors?.messages).toEqual(["stable threw", "own mount threw"]);
  });

  it("claims nothing when the own-props mounts stayed quiet", async () => {
    const capture = createFakeCapture();
    const result = comboResult(1);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 2,
      run: async (claimOwnWindow) => {
        claimOwnWindow();
        capture.raise("transition threw");
      },
    });

    expect(result.pageErrors).toBeUndefined();
    expect(result.transitionPageErrors?.errors.messages).toEqual(["transition threw"]);
  });
});

// The transition of the last row is to combo 0, not to a row that does not exist.

describe("which combo a transition points at", () => {
  it("wraps at the end of the combo list", () => {
    expect(nextComboIndex(3, 4)).toBe(0);
  });

  it("is the next index everywhere else", () => {
    expect(nextComboIndex(0, 4)).toBe(1);
    expect(nextComboIndex(2, 4)).toBe(3);
  });

  it("answers 0 for an empty combo list rather than NaN", () => {
    expect(nextComboIndex(0, 0)).toBe(0);
  });

  it("is what the recorded transition carries", async () => {
    const capture = createFakeCapture();
    const result = comboResult(3);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: nextComboIndex(3, 4),
      run: async () => {
        capture.raise("transition threw");
      },
    });

    expect(result.transitionPageErrors?.toComboIndex).toBe(0);
  });
});
