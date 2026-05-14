const getAppConfig = () => {
    const appEnv = import.meta.env.VITE_APP_TEST_CLIENT_APP_ENV;

    switch (appEnv) {
        case 'dev':
        case 'test':
        case 'stage':
        case 'prod':
            return {
                APP_ENV:           import.meta.env.VITE_APP_TEST_CLIENT_APP_ENV,
                BUILD_VERSION:     import.meta.env.VITE_APP_TEST_CLIENT_BUILD_VERSION,
                SOCKET_URL:        import.meta.env.VITE_APP_TEST_CLIENT_SOCKET_URL,
                BACKEND_URL:       import.meta.env.VITE_APP_TEST_CLIENT_BACKEND_URL,
            };
        case 'local':
        default:
            return {
                APP_ENV:           appEnv ? appEnv : 'local',
                BUILD_VERSION:     import.meta.env.VITE_APP_TEST_CLIENT_BUILD_VERSION,
                SOCKET_URL:        'ws://localhost:8000/ws',
                BACKEND_URL:       'http://localhost:8000',
            };
    }
};

export default getAppConfig();
