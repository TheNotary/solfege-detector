import { Link } from "react-router-dom";

export default function Home() {
    return (
        <>
            <h1>Welcome to test-client</h1>
            <ul>
                <li><Link to={`/`}>Home</Link></li>
                <li><Link to={`/resources`}>Resources (CRUD DEMO...)</Link></li>
            </ul>
        </>
    );
}
