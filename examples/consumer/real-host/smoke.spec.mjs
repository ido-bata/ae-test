import { test } from "@ido-bata/ae-test";

// Real-After-Effects smoke spec. Not part of the fake-host suite: run it with
//   ae-test --config ae-test.real.config.json
// which selects this directory, "host": "real", and your installDir. It needs
// a real .aep at fixtures/real-host.aep — see README.md "Real After Effects".
//
// "ADBE Gaussian Blur 2" is a built-in effect's match name (locale-independent).
// If your After Effects version names it differently, list candidates with
// layer.effects.all() — match names, not display names, because display names
// are localised.
const EFFECT = "ADBE Gaussian Blur 2";

test("Gaussian Blur changes a real render", async ({ ae, fixture, expect, expectFrame }) => {
  const project = await ae.openProject(fixture.project("real-host.aep"));
  const comp = await project.comp("Main");
  const info = await comp.info();
  const layer = await comp.layer("Solid 1");

  const effect = await layer.effects.apply(EFFECT);

  // Parameter display names are localised, so pick the writeable scalar by
  // shape instead of by name: the first OneD property with a numeric value.
  const parameters = await effect.parameters();
  const target = parameters.find(
    (p) => p.kind === "value" && p.valueType === "OneD" && typeof p.value === "number",
  );
  expect(target).toBeDefined();
  const parameter = effect.parameter(target.matchName ?? target.name);

  const before = await comp.renderFrame(0, { subdirectory: "before" });
  await parameter.set(10);
  const readBack = await parameter.get();
  expect(readBack).toBe(10);
  const after = await comp.renderFrame(0, { subdirectory: "after" });

  expectFrame(after).toHaveSize(info.width, info.height);
  expect(before.path).not.toBe(after.path);
  await expectFrame(after).toMatchSnapshot("real-gaussian-blur");
});
