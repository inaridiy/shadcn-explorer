import { type ComponentType, lazy, Suspense } from "react"

export default function dynamic<P extends object>(loader: () => Promise<ComponentType<P> | { default: ComponentType<P> }>) {
  const Lazy = lazy(async () => {
    const mod = await loader()
    return "default" in mod ? mod : { default: mod }
  })
  return (props: P) => (
    <Suspense fallback={null}>
      <Lazy {...props} />
    </Suspense>
  )
}
