extends SceneTree

## Level D behavioural scenario for the synthetic `counter` fixture.
##
## Runs against a GM2Godot-generated port of `fixtures/gm-projects/counter`. It instantiates the
## generated `obj_counter` scene, lets `_ready` register the instance, then calls the generated
## `_on_step` entry point exactly six times and records one event per step.
##
## The single observation channel is one line of the form:
##
##     DEEP_TRACE [ {step, kind, target, payload}, ... ]
##
## The JSON after the prefix is the event sequence itself (not a full trace document): the consumer
## `src/validation/trace.ts: observeTrace` parses it as a bare array of
## `TraceFileSchema.shape.events`. `fixtures/traces/counter_expected.json` carries the same events
## together with their provenance.
##
## All work happens on the first `_process` frame rather than in `_initialize`: a `--script`
## `SceneTree` is initialized before the root window is inside the tree, so a node added from
## `_initialize` would never receive `_ready` (and therefore would never register with the port's
## GML runtime).

const GMRuntime = preload("res://gm2godot/gml_runtime.gd")

const DEEP_TRACE_PREFIX := "DEEP_TRACE "
const FIXED_SEED := 12345
const STEP_COUNT := 6
const COUNTER_SCENE_PATH := "res://objects/obj_counter/obj_counter.tscn"
const CHILD_OBJECT_NAME := "obj_counter_child"
const GLOBAL_COUNTER := "counter"

var _completed := false

func _process(_delta: float) -> bool:
	if _completed:
		return true
	_completed = true

	# Explicit fixed seed: the fixture's step event does not use randomness, but the recorded trace
	# contract requires the scenario to state and pin its randomness mode.
	seed(FIXED_SEED)

	var packed := load(COUNTER_SCENE_PATH) as PackedScene
	if packed == null:
		push_error("counter_trace: could not load %s" % COUNTER_SCENE_PATH)
		quit(1)
		return true
	var instance := packed.instantiate()
	root.add_child(instance)

	var events: Array = []
	for step in range(STEP_COUNT):
		instance.call("_on_step")
		events.append(_observe_step(step, instance))

	print(DEEP_TRACE_PREFIX + JSON.stringify(events))
	quit(0)
	return true

func _observe_step(step: int, instance: Node) -> Dictionary:
	# `instance_position` is the GML API the pinned GM2Godot manifest reports as `partial`
	# (upstream issue #487); recording its observed result keeps that hazard visible in the trace.
	var hit: Variant = GMRuntime.gml_instance_position(instance, 0, 0, GMRuntime.gml_asset_get_index(CHILD_OBJECT_NAME))
	var hit_name := "noone"
	if GMRuntime.gml_ne(hit, GMRuntime.gml_instance_noone()):
		hit_name = CHILD_OBJECT_NAME
	return {
		"step": step,
		"kind": "step",
		"target": "obj_counter",
		"payload": {
			"counter_step": _number_or_null(instance.get("counter_step")),
			"global.counter": _number_or_null(GMRuntime.gml_selector_get(GMRuntime.gml_global_scope(), GLOBAL_COUNTER)),
			"instance_position": hit_name,
		},
	}

func _number_or_null(value: Variant) -> Variant:
	if value == null or GMRuntime.is_undefined(value):
		return null
	return int(value)
