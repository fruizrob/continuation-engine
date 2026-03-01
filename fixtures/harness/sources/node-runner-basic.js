const accumulator = [1, 2, 3].reduce((sum, n) => sum + n, 0);

delorean.insertTimepoint("GoldenTimepoint");

const continuation = callCC((cont) => cont);
if (typeof continuation === "function") {
  continuation;
}

delorean.insertBreakpoint("GoldenBreakpoint");

accumulator;
