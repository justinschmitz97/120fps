
import type { DefineComponent, SlotsType } from 'vue'
type LazyComponent<T> = DefineComponent<{}, {}, {}, {}, {}, {}, {}, { hydrated: () => void }> & T

export const Greeting: typeof import("../app/components/Greeting.vue")['default']
export const Departed: typeof import("../app/components/Departed.vue")['default']
export const LazyGreeting: LazyComponent<typeof import("../app/components/Greeting.vue")['default']>

export const componentNames: string[]
