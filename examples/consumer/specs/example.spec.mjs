import { test } from "@ido-bata/ae-test";

// This spec runs against ae-a8n's in-process fake host, which knows the
// "ADBE Fake Gaussian Blur" effect and the "Main"/"Solid 1" fixture names.
// Against a real After Effects it fails by design — see README.md for the
// real-host variant, which builds its own disposable comp and a real
// effect match name.
test("Gaussian Blur changes the pixels", async ({ ae, fixture, expectFrame }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const effect = await (await comp.layer("Solid 1")).effects.apply("ADBE Fake Gaussian Blur");

  const before = await comp.renderFrame(0, { subdirectory: "before" });
  await effect.parameter("Amount").set(10);
  const after = await comp.renderFrame(0, { subdirectory: "after" });

  expectFrame(after).toHaveSize(before.width, before.height);
  await expectFrame(after).toMatchSnapshot("blurred");
});
