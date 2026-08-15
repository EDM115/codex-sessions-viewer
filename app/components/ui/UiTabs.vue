<script setup lang="ts">
export interface UiTabItem {
  value: string;
  label: string;
  count?: number;
  disabled?: boolean;
}

const props = defineProps<{
  items: UiTabItem[];
  label: string;
  modelValue: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

function enabledIndexes(): number[] {
  return props.items.flatMap((item, index) => (item.disabled ? [] : [index]));
}

function selectIndex(index: number, event: KeyboardEvent): void {
  const item = props.items[index];
  if (item === undefined || item.disabled) {
    return;
  }
  emit("update:modelValue", item.value);
  const list = (event.currentTarget as HTMLElement).closest('[role="tablist"]');
  const target = list?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index];
  target?.focus({ preventScroll: true });
}

function handleKeydown(event: KeyboardEvent, index: number): void {
  const indexes = enabledIndexes();
  const current = indexes.indexOf(index);
  let target: number | undefined;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    target = indexes[(current + 1) % indexes.length];
  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    target = indexes[(current - 1 + indexes.length) % indexes.length];
  } else if (event.key === "Home") {
    target = indexes[0];
  } else if (event.key === "End") {
    target = indexes.at(-1);
  }
  if (target !== undefined) {
    event.preventDefault();
    selectIndex(target, event);
  }
}
</script>

<template>
  <div class="ui-tabs" role="tablist" :aria-label="label">
    <button
      v-for="(item, index) in items"
      :key="item.value"
      type="button"
      class="ui-tabs__tab interactive-control"
      role="tab"
      :disabled="item.disabled"
      :aria-selected="item.value === modelValue ? 'true' : 'false'"
      :tabindex="item.value === modelValue ? 0 : -1"
      @click="emit('update:modelValue', item.value)"
      @keydown="handleKeydown($event, index)"
    >
      <span>{{ item.label }}</span>
      <span v-if="item.count !== undefined" class="ui-tabs__count tabular">{{ item.count }}</span>
    </button>
  </div>
</template>
