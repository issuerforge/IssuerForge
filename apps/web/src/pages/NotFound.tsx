import { Link, useLocation } from 'react-router-dom'

const NotFound = () => {
  const location = useLocation()

  return (
    <div className="mx-auto max-w-[560px] px-5 py-24">
      <h1 className="section-head block">Page not found</h1>
      <p className="mono12 muted mt-4 break-all">{location.pathname}</p>
      <p className="mt-6">
        <Link to="/" className="btn-plain">
          Return to the console
        </Link>
      </p>
    </div>
  )
}

export default NotFound
