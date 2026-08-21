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

// The whole delta-loop window is transition by construction. The loop's
// `mountAndWait(props)` re-mounts combo N's props over the page state the
// PREVIOUS sample's `rerenderAndTrace(nextProps)` left behind, so an error it
// raises is an N+1 -> N artefact (radix Label: leaving `asChild: true` throws a
// Slot error while mounting N's props). Attributing that mount to N produced
// both `[1 page error]` and `[-> #3: 1 page error]` on the same row. N's own
// deterministic errors are already captured by the stable-sample pass that runs
// before this window opens.

describe("the mounts the prop-change loop performs with the combo's own props", () => {
  it("attributes an error raised anywhere in the delta loop to the transition", async () => {
    const capture = createFakeCapture();
    const result = comboResult(2);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 3,
      run: async () => {
        capture.raise("Primitive.label failed to slot onto its children.");
      },
    });

    expect(result.pageErrors).toBeUndefined();
    expect(result.transitionPageErrors?.errors.messages).toEqual([
      "Primitive.label failed to slot onto its children.",
    ]);
  });

  it("does not tag a row with both its own and a transition error for one throw", async () => {
    const capture = createFakeCapture();
    const result = comboResult(2);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 3,
      run: async () => {
        capture.raise("Primitive.label failed to slot onto its children.");
      },
    });

    const tagged = [result.pageErrors, result.transitionPageErrors?.errors].filter(Boolean);
    expect(tagged).toHaveLength(1);
  });

  it("keeps what the stable pass raised on the combo's own window", async () => {
    const capture = createFakeCapture();
    capture.raise("stable threw");
    const result = comboResult(1);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 2,
      run: async () => {
        capture.raise("delta threw");
      },
    });

    expect(result.pageErrors?.messages).toEqual(["stable threw"]);
    expect(result.transitionPageErrors?.errors.messages).toEqual(["delta threw"]);
  });

  it("still lets a transition body claim a sub-step for the combo when it can prove it", async () => {
    const capture = createFakeCapture();
    const result = comboResult(1);

    await runWithSplitErrorWindows(capture, result, {
      toComboIndex: 2,
      run: async (claimOwnWindow) => {
        capture.raise("provably own");
        claimOwnWindow();
        capture.raise("transition threw");
      },
    });

    expect(result.pageErrors?.messages).toEqual(["provably own"]);
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
