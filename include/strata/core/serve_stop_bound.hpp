#pragma once
#include <algorithm>
#include <cstdint>
#include <cstring>

namespace strata::core {
// A committed input row must correspond to an output the caller can expose.
// The last exposed output remains the next unconsumed token, as in the scalar loop.
template<class Token, class IsEos>
int serve_stop_bound(int accepted, int64_t remaining, const Token* outputs, IsEos is_eos) {
    const int count = static_cast<int>(std::min<int64_t>(accepted, std::max<int64_t>(0, remaining)));
    for (int i = 0; i < count; ++i)
        if (is_eos(outputs[i])) return i + 1;
    return count;
}
// Limit cached speculative rows on every backend by default. The emitted answer is unchanged.
inline bool serve_stop_bound_on(const char* value) {
    return value == nullptr || std::strcmp(value, "0") != 0;
}
}
