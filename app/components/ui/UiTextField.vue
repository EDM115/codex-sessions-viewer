<script setup lang="ts">
import { PhCheckCircle, PhSpinnerGap, PhWarningCircle } from "@phosphor-icons/vue";
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    autocomplete?: string;
    disabled?: boolean;
    helper?: string;
    id: string;
    label: string;
    message?: string;
    modelValue: string;
    placeholder?: string;
    readonly?: boolean;
    state?: "default" | "loading" | "error" | "success";
    type?: "search" | "text" | "url";
  }>(),
  {
    autocomplete: "off",
    disabled: false,
    helper: "",
    message: "",
    placeholder: "",
    readonly: false,
    state: "default",
    type: "text",
  },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const messageId = computed(() => `${props.id}-message`);
const currentMessage = computed(() => props.message || props.helper);

function updateValue(event: Event): void {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
}
</script>

<template>
  <label class="ui-field" :for="id">
    <span class="ui-field__label">{{ label }}</span>
    <span class="ui-field__control-wrap">
      <input
        :id="id"
        class="ui-field__control interactive-control"
        :class="state === 'default' ? null : `is-${state}`"
        :type="type"
        :value="modelValue"
        :placeholder="placeholder"
        :autocomplete="autocomplete"
        :disabled="disabled"
        :readonly="readonly"
        :aria-busy="state === 'loading' ? 'true' : undefined"
        :aria-describedby="messageId"
        :aria-invalid="state === 'error' ? 'true' : undefined"
        @input="updateValue"
      />
      <span class="ui-field__status" aria-hidden="true">
        <PhSpinnerGap
          v-if="state === 'loading'"
          class="ui-control__state-icon--spinning"
          :size="18"
          weight="regular"
        />
        <PhWarningCircle v-else-if="state === 'error'" :size="18" weight="regular" />
        <PhCheckCircle v-else-if="state === 'success'" :size="18" weight="regular" />
      </span>
    </span>
    <span
      :id="messageId"
      class="ui-field__message"
      :class="state === 'error' ? 'ui-field__message--error' : null"
    >
      {{ currentMessage }}
    </span>
  </label>
</template>
