import ViewPageClient from './ViewPageClient'

type SlugParams = { slug?: string[] }

type PageProps = {
  params: SlugParams | Promise<SlugParams>
}

export default async function ViewPage({ params }: PageProps) {
  const resolved = params instanceof Promise ? await params : params
  const slugParts = resolved.slug ?? []
  return <ViewPageClient slugParts={slugParts} />
}
