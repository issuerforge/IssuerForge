import { Link, useLocation } from 'react-router-dom'

const NotFound = () => {
  const location = useLocation()

  return (
    <div className="mx-auto max-w-[1180px] px-5 py-16">
      <h1 className="section-head block">Page not found</h1>
      <p className="mono12 muted mt-4 break-all">{location.pathname}</p>
      <p className="mt-6">
        <Link to="/" className="btn-plain">
          Return to step 1 of the wizard
        </Link>
      </p>
    </div>
  )
}

export default NotFound
