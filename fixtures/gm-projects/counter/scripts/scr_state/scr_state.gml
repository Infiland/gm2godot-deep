/// Helpers around the shared counter plus two deliberately dynamic
/// references that static analysis must record as unresolved rather than
/// guess. This script calls scr_math_add, which together with scr_math.gml
/// reading global.counter forms the scr_math <-> scr_state cycle.

/// Resets the shared counter and clears the dynamic dispatch handler.
function scr_state_reset() {
    global.counter = 0;
    global.handler = -1;
}

/// Adds _n to the shared counter through scr_math_add and returns it.
function scr_state_advance(_n) {
    global.counter = scr_math_add(global.counter, _n);
    return global.counter;
}

/// Calls a handler that is only known at runtime, then resolves a sprite
/// whose asset name is built by string concatenation. Both are statically
/// unresolved on purpose.
function scr_state_dispatch(_n) {
    script_execute(global.handler, _n);
    var _sprite = asset_get_index("spr_" + string(_n));
    return _sprite;
}
