from setuptools import setup, find_packages

setup(name='solfege-detector',
    version='0.1',
    description='',
    url='https://github.com/TheNotary/solfege-detector',
    author='TheNotary',
    author_email='no@email.plz',
    license='MIT',
    packages=find_packages(),
    install_requires=[
        'setuptools',
				'torch',
        'transformers',
				'numpy<2.0.0'
    ],
    entry_points={
        'console_scripts': [
            'solfege-detector=solfege_detector.main:main',
        ],
    },
    tests_require=['pytest'], # This appears to be unnecessary in 2025
    zip_safe=False)
