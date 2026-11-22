import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './App.vue'
import HomePage from './pages/HomePage.vue'
import DomainPage from './pages/DomainPage.vue'
import TopicPage from './pages/TopicPage.vue'
import NotePage from './pages/NotePage.vue'
import AggregatePage from './pages/AggregatePage.vue'
import SearchPage from './pages/SearchPage.vue'
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
  ],
  scrollBehavior: () => ({ top: 0 }),
})

createApp(App).use(router).mount('#app')
