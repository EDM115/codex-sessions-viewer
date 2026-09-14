import { config } from "@vue/test-utils";
import { defineComponent, h, type PropType } from "vue";

// Unit mounts do not run Nuxt's component registration. Browser tests verify actual routing.
config.global.stubs["NuxtLink"] = defineComponent({
  props: {
    to: {
      type: [String, Object] as PropType<
        string | { path: string; query?: Record<string, string>; hash?: string }
      >,
      required: true,
    },
    prefetch: Boolean,
  },
  setup(props, { slots }) {
    return () => {
      const to = props.to;
      const query = typeof to === "string" ? "" : new URLSearchParams(to.query).toString();
      return h(
        "a",
        {
          href:
            typeof to === "string"
              ? to
              : `${to.path}${query === "" ? "" : `?${query}`}${to.hash ?? ""}`,
        },
        slots["default"]?.(),
      );
    };
  },
});
