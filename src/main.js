import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import HomePage from './pages/HomePage.vue'
import DomainPage from './pages/DomainPage.vue'
import TopicPage from './pages/TopicPage.vue'
import NotePage from './pages/NotePage.vue'
import AggregatePage from './pages/AggregatePage.vue'
import SearchPage from './pages/SearchPage.vue'
import OrphanPage from './pages/OrphanPage.vue'
import TrashPage from './pages/TrashPage.vue'
import { idifyLinks } from './lib/store.js'
import 'katex/dist/katex.min.css'
import './styles.css'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: HomePage },
    { path: '/d/:domainId', component: DomainPage },
    { path: '/t/:topicId', component: TopicPage },
    { path: '/n/:noteId', component: NotePage },
    { path: '/agg/:kind', component: AggregatePage },
    { path: '/search', component: SearchPage },
    { path: '/orphans', component: OrphanPage },
    { path: '/trash', component: TrashPage },
  ],
  scrollBehavior: () => ({ top: 0 }),
})

// 老内容里的 [[标题]] 换成一劳永逸的 [[id]]（只跑一次，之后靠 localStorage 标记跳过）
idifyLinks()

createApp(App).use(router).mount('#app')
