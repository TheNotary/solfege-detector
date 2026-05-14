import './App.css'
import { Link, Route, Routes } from 'react-router-dom'
import ErrorBanner from "./shared/ErrorBanner";
import Home from './views/Home'
import ResourceList from './views/ResourceList'
import ResourceDetail from './views/ResourceDetail'

function App() {
    return (
        <>
            <nav><Link to="/">Home</Link> | <Link to="/resources">Resources</Link></nav>
            <ErrorBanner />
            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/resources" element={<ResourceList />} />
                <Route path="/resources/:id" element={<ResourceDetail />} />
            </Routes>
        </>
    )
}

export default App
