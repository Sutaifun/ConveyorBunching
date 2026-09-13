/**
 * 本地预览入口。只服务于 `npm run play`，不会随组件一起进博客
 * —— 博客那边已经装好了 Vue 和 Element Plus，只需要 KettlePlayer.vue 本身。
 */
import { createApp } from 'vue';
import 'element-plus/dist/index.css';
import KettlePlayer from './KettlePlayer.vue';

createApp(KettlePlayer).mount('#app');
