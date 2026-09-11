/// Adds two numbers and returns the result.
function scr_math_add(_a, _b) {
    return _a + _b;
}

/// Scales a value by the shared counter that scr_state owns.
/// This read is what gives the scr_math unit a shared_state edge on
/// global.counter, which is the other half of the scr_math <-> scr_state
/// cycle (scr_state.gml calls scr_math_add).
function scr_math_scale(_value) {
    return _value * max(global.counter, 1);
}
