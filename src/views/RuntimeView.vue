<script setup lang="ts">
import PageHeader from '@/components/common/PageHeader.vue'
import TaskMonitorPanel from '@/components/runtime/TaskMonitorPanel.vue'
</script>

<template>
  <div class="h-full flex flex-col overflow-hidden">
    <PageHeader
      title="Runtime"
      description="实时任务运行监控"
    />
    <div class="flex-1 overflow-y-auto">
      <TaskMonitorPanel />
    </div>
  </div>
</template>
