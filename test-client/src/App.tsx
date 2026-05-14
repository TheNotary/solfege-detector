import './App.css'
import { Route, Routes } from 'react-router-dom'
import ErrorBanner from "./shared/ErrorBanner";
import Home from './views/Home'

function App() {
    return (
        <>
            <ErrorBanner />
            <Routes>
                <Route path="/" element={<Home />} />
            </Routes>
        </>
    )
}

export default App
