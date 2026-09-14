export const BENCHMARK_VERSION = "2";
export interface BenchmarkCase {
  id: string;
  source: string;
  question: string;
  expected: Record<string, boolean>;
  uncertain: boolean;
}
/** Synthetic, bounded source; benchmark setup never sends the user's project. */
export const BENCHMARKS: readonly BenchmarkCase[] = [
  {
    id: "lifecycle",
    source:
      "// obj_player/Create.gml\nhp = 3;\n// obj_player/Step.gml\nif (hp <= 0) instance_destroy();",
    question:
      "Identify initialization and repeated behavior. Facts: create_initializes_hp, step_checks_death, destroy_means_quit_game.",
    expected: {
      create_initializes_hp: true,
      step_checks_death: true,
      destroy_means_quit_game: false,
    },
    uncertain: false,
  },
  {
    id: "dependencies",
    source:
      "// scripts/heal.gml\nfunction heal(target) { target.hp += global.heal_amount; }\n// obj_player/Create.gml\nhp=3; heal(id);",
    question:
      "Identify cross-resource state. Facts: heal_mutates_target_hp, reads_shared_global, global_value_known.",
    expected: {
      heal_mutates_target_hp: true,
      reads_shared_global: true,
      global_value_known: false,
    },
    uncertain: true,
  },
  {
    id: "gdscript",
    source: "// obj_player/Step.gml\nx += 2;",
    question:
      "Convert this fixed-tick GML motion into an equivalent GDScript method in the gdscript field. Facts: physics_process_preserves_fixed_ticks, use_position_x, multiply_by_delta_without_rescaling_preserves_speed.",
    expected: {
      physics_process_preserves_fixed_ticks: true,
      use_position_x: true,
      multiply_by_delta_without_rescaling_preserves_speed: false,
    },
    uncertain: false,
  },
  {
    id: "unsupported",
    source:
      '// obj_loader/Create.gml\nscript_execute(asset_get_index(variable_global_get("plugin_script")));',
    question:
      "Can the exact call target be resolved statically? Facts: target_statically_known, requires_runtime_value, should_record_blocker.",
    expected: {
      target_statically_known: false,
      requires_runtime_value: true,
      should_record_blocker: true,
    },
    uncertain: true,
  },
];
