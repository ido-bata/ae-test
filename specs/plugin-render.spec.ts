/**
 * The vertical slice, written the way a plugin author would write it.
 *
 * ```text
 * external code → ae-test → ae-a8n → After Effects → plugin → render → assert
 * ```
 *
 * Nothing below knows about envelopes, host scripts, or the file-based result
 * channel. That separation is the point of the layering, so this file is also
 * the test of it.
 */

// Imported through the package's built entry point, not `src/`, so the spec
// exercises the same surface a consumer gets. That also means the CLI can run
// it under plain Node with no TypeScript loader in the path.
import { test } from "../dist/index.js";

/**
 * A match name the fake host registers. Against a real After Effects this
 * becomes a genuine plugin's match name; nothing else about the spec changes.
 */
const EFFECT = "ADBE Fake Gaussian Blur";

test("applies a plugin effect and renders a frame", async ({
  ae,
  fixture,
  expect,
  expectFrame,
}) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const layer = await comp.layer("Solid 1");

  const effect = await layer.effects.apply(EFFECT);
  expect(effect.name).toBe("AE Fake Gaussian Blur");

  const frame = await comp.renderFrame(0);
  expectFrame(frame).toHaveSize(64, 64);
  expectFrame(frame).toPath(/\.png$/);
  await expectFrame(frame).toMatchSnapshot("main-frame-0");
});

test("reads a parameter back after setting it", async ({ ae, fixture, expect }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const layer = await comp.layer("Solid 1");
  const effect = await layer.effects.apply(EFFECT);

  const applied = await effect.parameter("Amount").set(42);
  expect(applied).toBe(42);

  const readBack = await effect.parameter("Amount").get();
  expect(readBack).toBe(42);
});

test("the parameter reaches the pixels", async ({ ae, fixture, expect }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const layer = await comp.layer("Solid 1");
  const effect = await layer.effects.apply(EFFECT);

  // Two renders of the same frame must differ once the effect is configured.
  // This is the assertion that would actually catch a plugin silently ignoring
  // its parameters.
  const before = await comp.renderFrame(0, { subdirectory: "unconfigured" });
  await effect.parameter("Amount").set(75);
  const after = await comp.renderFrame(0, { subdirectory: "configured" });

  expect(before.width).toBe(after.width);
  expect(before.height).toBe(after.height);
  expect(before.path).not.toBe(after.path);
});

test("reports a missing composition as a typed failure", async ({ ae, fixture, expect }) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  await (await expect(project.comp("Does Not Exist")).rejects()).toMatchObject({
    name: "EntityNotFoundError",
    kind: "composition",
  });
});
