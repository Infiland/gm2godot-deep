/// Step event for obj_counter. Property 2 of the fixture: this event calls
/// the script function scr_math_add and writes the shared global.counter.
/// It also calls instance_position, which the pinned GM2Godot manifest
/// reports as status "partial" (upstream issue #487).
counter_step = scr_math_add(counter_step, 1);
global.counter = counter_step;

var _hit = instance_position(x, y, obj_counter_child);
if (_hit != noone) {
    counter_step = scr_math_add(counter_step, 1);
}
