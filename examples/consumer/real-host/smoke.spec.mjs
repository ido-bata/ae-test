import { test } from "@ido-bata/ae-test";

// Real-After-Effects smoke spec. Not part of the fake-host suite: run it with
//   ae-test --config ae-test.real.config.json
// which selects this directory, "host": "real", and your installDir. It needs
// no .aep fixture — the spec builds a disposable comp at run time (see
// README.md "Real After Effects").
//
// "ADBE Gaussian Blur 2" is a built-in effect's match name (locale-independent).
// If your After Effects version names it differently, list candidates with
// layer.effects.all() — match names, not display names, because display names
// are localised.
const EFFECT = "ADBE Gaussian Blur 2";
// The effect's Blurriness parameter, again by match name: display names are
// localised and parameter order is not a contract, so neither identifies it.
const BLURRINESS = `${EFFECT}-0001`;
const BLURRINESS_VALUE = 50;

test("Gaussian Blur changes a real render", async ({ ae, expect, expectFrame }) => {
  // Disposable fixture: a comp with one text layer. Text gives the blur
  // high-contrast edges, so a parameter that reaches the pixels cannot pass
  // as a no-op the way it could on a uniform solid. Font, colour, size and
  // position are set explicitly so the fixture does not depend on AE
  // defaults. The untitled project is never saved; teardown discards it.
  const project = await ae.project();
  const comp = await project.createComp({
    name: "Main",
    width: 320,
    height: 180,
    duration: 1,
    frameRate: 30,
  });
  const { layer } = await comp.addTextLayer({
    text: "AE",
    name: "Text 1",
    fontSize: 64,
    fillColor: [1, 0, 0],
    position: [160, 90],
  });
  const info = await comp.info();

  // Three renders isolate what changed: `before` has no effect, `applied`
  // has the effect at its defaults, `after` has the parameter written. The
  // pixel assertions below compare content, so "the files have different
  // paths" can never pass as a change — and a parameter the renderer
  // ignores cannot hide behind the effect's own default output.
  const before = await comp.renderFrame(0, { subdirectory: "before" });

  const effect = await layer.effects.apply(EFFECT);
  const applied = await comp.renderFrame(0, { subdirectory: "applied" });

  // Identify the parameter by meaning: the Blurriness match name must be
  // among the effect's declared parameters, and it must be a writable scalar.
  const parameters = await effect.parameters();
  const blurriness = parameters.find((p) => p.matchName === BLURRINESS);
  expect(blurriness).toBeDefined();
  expect(blurriness.kind).toBe("value");
  expect(blurriness.valueType).toBe("OneD");

  const parameter = effect.parameter(BLURRINESS);
  await parameter.set(BLURRINESS_VALUE);
  const readBack = await parameter.get();
  expect(readBack).toBe(BLURRINESS_VALUE);

  const after = await comp.renderFrame(0, { subdirectory: "after" });

  expectFrame(after).toHaveSize(info.width, info.height);
  // The load-bearing assertions: pixels must actually differ. Against
  // `applied` this proves the parameter reached the render; against
  // `before` it proves the effect changed anything at all. The options are
  // the same tolerances toMatchFrame honours — here they set how much of a
  // difference still counts as "nothing changed".
  await expectFrame(after).toDifferFromFrame(applied, { maxDiffPixelRatio: 0.001 });
  await expectFrame(after).toDifferFromFrame(before, { maxDiffPixelRatio: 0.001 });
  await expectFrame(after).toMatchSnapshot("real-gaussian-blur");
});
