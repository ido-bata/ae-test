/**
 * Real-host conformance suite: the scripting domain of ae-a8n's built-in
 * dispatch table, exercised through ae-test's public API on a disposable
 * project and on the committed fixture project.
 *
 * This file is intentionally NOT named `*.spec.*`: the default spec
 * discovery (`**/*.spec.*`) must keep selecting only the fake-host suite.
 * Run it explicitly:
 *
 *   node dist/cli.js --config conformance/real-host/ae-test.config.json \
 *     --install-dir "/Applications/Adobe After Effects 2026" \
 *     --conformance --capability-catalog <ae-devtools catalog.json>
 *
 * Capability IDs follow ae-a8n's built-in dispatch table
 * (`ae.operation.*` semantic operations), which is the same ID space the
 * ae-devtools capability catalog validates against.
 */

import { test } from "../../dist/index.js";

// A built-in effect's match name is locale-independent; display names are
// not, so match names are the only honest identifier.
const EFFECT = "ADBE Gaussian Blur 2";
const BLURRINESS = `${EFFECT}-0001`;
const BLURRINESS_VALUE = 50;

test("reads project, composition and layer state", async ({
  ae,
  fixture,
  expect,
}) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const projectInfo = await project.info();
  expect(projectInfo.file).toContain("fixture.aep");

  const comps = await project.comps();
  expect(comps.some((comp) => comp.name === "Main")).toBe(true);

  const comp = await project.comp("Main");
  const compInfo = await comp.info();
  expect(compInfo.name).toBe("Main");

  const layers = await comp.layers();
  expect(layers.some((layer) => layer.name === "Solid 1")).toBe(true);

  const layer = await comp.layer("Solid 1");
  const layerInfo = await layer.info();
  expect(layerInfo.name).toBe("Solid 1");

  const transform = await layer.transform();
  expect(transform).toBeDefined();

  // The not-found path is part of the read contract: a missing comp is a
  // typed refusal, not a generic failure.
  await (await expect(project.comp("Does Not Exist")).rejects()).toMatchObject({
    name: "EntityNotFoundError",
    kind: "composition",
  });
}, {
  capabilities: [
    "ae.operation.project.open",
    "ae.operation.project.info",
    "ae.operation.project.list-comps",
    "ae.operation.comp.info",
    "ae.operation.comp.list-layers",
    "ae.operation.layer.get-layer",
    "ae.operation.layer.get-transform",
  ],
});

test("writes state on a disposable project", async ({ ae, expect }) => {
  // `ae.project()` binds the untitled project AE always has open; nothing
  // is saved, so teardown's discard leaves no trace.
  const project = await ae.project();
  const comp = await project.createComp({
    name: "Disposable",
    width: 64,
    height: 64,
    duration: 1,
    frameRate: 30,
  });
  const { layer } = await comp.addTextLayer({
    text: "AE",
    name: "Text 1",
    fontSize: 32,
    fillColor: [1, 0, 0],
    position: [32, 32],
  });

  const selected = await comp.selectLayers(["Text 1"]);
  expect(selected).toContain("Text 1");

  const disabled = await layer.setEnabled(false);
  expect(disabled.enabled).toBe(false);
  const reenabled = await layer.setEnabled(true);
  expect(reenabled.enabled).toBe(true);

  const layers = await comp.layers();
  expect(layers.some((entry) => entry.name === "Text 1")).toBe(true);

  await comp.openInViewer();
}, {
  capabilities: [
    "ae.operation.project.info",
    "ae.operation.comp.create",
    "ae.operation.layer.add-text",
    "ae.operation.layer.select",
    "ae.operation.layer.set-enabled",
    "ae.operation.comp.list-layers",
    "ae.operation.comp.open-in-viewer",
  ],
});

test("applies an effect and round-trips its parameters", async ({
  ae,
  fixture,
  expect,
}) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const layer = await (await project.comp("Main")).layer("Solid 1");

  const all = await layer.effects.all();
  expect(Array.isArray(all)).toBe(true);

  const effect = await layer.effects.apply(EFFECT);
  expect(effect.name).toBeDefined();

  const parameters = await effect.parameters();
  const blurriness = parameters.find((p) => p.matchName === BLURRINESS);
  expect(blurriness).toBeDefined();
  expect(blurriness.kind).toBe("value");
  expect(blurriness.valueType).toBe("OneD");

  const parameter = effect.parameter(BLURRINESS);
  const written = await parameter.set(BLURRINESS_VALUE);
  expect(written).toBe(BLURRINESS_VALUE);
  const readBack = await parameter.get();
  expect(readBack).toBe(BLURRINESS_VALUE);
  const described = await parameter.info();
  expect(described.value).toBe(BLURRINESS_VALUE);
}, {
  capabilities: [
    "ae.operation.project.open",
    "ae.operation.comp.info",
    "ae.operation.layer.get-layer",
    "ae.operation.layer.list-effects",
    "ae.operation.effect.apply",
    "ae.operation.effect.list-parameters",
    "ae.operation.effect.set-parameter",
    "ae.operation.effect.get-parameter",
  ],
});

test("renders frames whose pixels respond to the parameter", async ({
  ae,
  fixture,
  expect,
  expectFrame,
}) => {
  const project = await ae.openProject(fixture.project("fixture.aep"));
  const comp = await project.comp("Main");
  const layer = await comp.layer("Solid 1");

  // Three renders isolate the parameter's effect on pixels: `before` has
  // no effect, `applied` has it at defaults, `after` has Blurriness set.
  const before = await comp.renderFrame(0, { subdirectory: "before" });
  const effect = await layer.effects.apply(EFFECT);
  const applied = await comp.renderFrame(0, { subdirectory: "applied" });
  await effect.parameter(BLURRINESS).set(BLURRINESS_VALUE);
  const after = await comp.renderFrame(0, { subdirectory: "after" });

  expectFrame(after).toHaveSize(before.width, before.height);
  await expectFrame(after).toDifferFromFrame(applied, { maxDiffPixelRatio: 0.001 });
  await expectFrame(after).toDifferFromFrame(before, { maxDiffPixelRatio: 0.001 });
  await expectFrame(after).toMatchSnapshot("real-gaussian-blur");
}, {
  capabilities: [
    "ae.operation.project.open",
    "ae.operation.comp.info",
    "ae.operation.layer.get-layer",
    "ae.operation.effect.apply",
    "ae.operation.effect.set-parameter",
    "ae.operation.render.frame",
  ],
});
