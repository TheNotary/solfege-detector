import './App.css'
import { Route, Routes } from 'react-router-dom'
import ErrorBanner from "./shared/ErrorBanner";
import MainMenu from './views/MainMenu'
import GameView from './views/GameView'
import ConfigView from './views/ConfigView'
import CalibrateView from './views/CalibrateView'

function App() {
    return (
        <>
            <ErrorBanner />
            <Routes>
                <Route path="/" element={<MainMenu />} />
                <Route path="/play" element={<GameView />} />
                <Route path="/calibrate" element={<CalibrateView />} />
                <Route path="/config" element={<ConfigView />} />
            </Routes>
        </>
    )
}

export default App
