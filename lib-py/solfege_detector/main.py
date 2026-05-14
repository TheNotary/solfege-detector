# Debugging
import pdb
import traceback

# Built-in dependencies
import os
import sys

# Local scripts
from solfege_detector.config_helper import lookup_env_variables
from solfege_detector.sayer import Sayer


# This is the main entrypoint of the project defined by setup.py
# which will be invoked when the user runs `solfege_detector` from the command line
# following installation.
def main():
    username, password = lookup_env_variables()

    sayer = Sayer(greeting = "Sup")
    print( sayer.say_hi() + " " + username + "!" )

    # Useful debugging instructions
    # pdb.set_trace()
    dir(os)

# Here's python boilerplate for running the main function only when this script is run directly
# (i.e. not when it's imported as a library)
if __name__ == "__main__":
    main()
