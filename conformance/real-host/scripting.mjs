/**
 * Real-host conformance suite: the scripting domain of ae-a8n's built-in
 * dispatch table, exercised through ae-test's public API.
 *
 * Every test works on the untitled project After Effects always has open:
 * it creates a disposable comp and text layer, and teardown's discard
 * leaves nothing behind. No `.aep` fixture is required — the committed
 * `fixtures/fixture.aep` is a fake-host placeholder, not a real project.
 *
 * This file is intentionally NOT named `*.spec.*`: the default spec
 * discovery must keep selecting only the fake-host suite.
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

// Match names are locale-independent; display names are not.
const EFFECT = "ADBE Gaussian Blur 2";
const BLURRINESS = `${EFFECT}-0001`;
const BLURRINESS_VALUE = 50;

const COMP = {
  name: "Disposable",
  width: 64,
  height: 64,
  duration: 1,
  frameRate: 30,
};

const TEXT = {
  text: "AE",
  name: "Text 1",
  // PostScript name: without it AE picks a machine-specific default font and
  // the recorded render baseline stops being comparable across machines.
  font: "Helvetica",
  fontSize: 32,
  fillColor: [1, 0, 0],
  position: [32, 32],
};

test("reads project, composition and layer state", async ({
  ae,
  expect,
}) => {
  const project = await ae.project();
  const projectInfo = await project.info();
  expect(projectInfo).toBeDefined();

  await project.createComp(COMP);
  const comps = await project.comps();
  expect(comps.some((comp) => comp.name === COMP.name)).toBe(true);

  const comp = await project.comp(COMP.name);
  const compInfo = await comp.info();
  expect(compInfo.name).toBe(COMP.name);

  const { layer } = await comp.addTextLayer(TEXT);
  const layers = await comp.layers();
  expect(layers.some((entry) => entry.name === layer.name)).toBe(true);

  const resolved = await comp.layer(layer.name);
  const layerInfo = await resolved.info();
  expect(layerInfo.name).toBe(layer.name);

  const transform = await resolved.transform();
  expect(transform).toBeDefined();

  // The not-found path is part of the read contract: a missing comp is a
  // typed refusal, not a generic failure.
  await (await expect(project.comp("Does Not Exist")).rejects()).toMatchObject({
    name: "EntityNotFoundError",
    kind: "composition",
  });
}, {
  capabilities: [
    "ae.operation.project.info",
    "ae.operation.project.list-comps",
    "ae.operation.comp.create",
    "ae.operation.comp.info",
    "ae.operation.comp.list-layers",
    "ae.operation.layer.add-text",
    "ae.operation.comp.get-layer",
    "ae.operation.layer.get-transform",
  ],
});

test("writes state on a disposable project", async ({ ae, expect }) => {
  const project = await ae.project();
  const comp = await project.createComp(COMP);
  const { layer } = await comp.addTextLayer(TEXT);

  const selected = await comp.selectLayers([layer.name]);
  expect(selected.includes(layer.name)).toBe(true);

  const disabled = await layer.setEnabled(false);
  expect(disabled.enabled).toBe(false);
  const reenabled = await layer.setEnabled(true);
  expect(reenabled.enabled).toBe(true);

  const layers = await comp.layers();
  expect(layers.some((entry) => entry.name === layer.name)).toBe(true);

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
  expect,
}) => {
  const project = await ae.project();
  const comp = await project.createComp(COMP);
  const { layer } = await comp.addTextLayer(TEXT);

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
    "ae.operation.project.info",
    "ae.operation.comp.create",
    "ae.operation.layer.add-text",
    "ae.operation.layer.list-effects",
    "ae.operation.effect.apply",
    "ae.operation.effect.list-parameters",
    "ae.operation.effect.set-parameter",
    "ae.operation.effect.get-parameter",
  ],
});

test("renders frames whose pixels respond to the parameter", async ({
  ae,
  expect,
  expectFrame,
}) => {
  const project = await ae.project();
  const comp = await project.createComp(COMP);
  const { layer } = await comp.addTextLayer(TEXT);

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
    "ae.operation.project.info",
    "ae.operation.comp.create",
    "ae.operation.layer.add-text",
    "ae.operation.effect.apply",
    "ae.operation.effect.set-parameter",
    "ae.operation.render.frame",
  ],
});
