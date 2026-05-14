import os
import sys

def lookup_env_variables():
    try:
        username = os.environ["PYTHON_APP_USERNAME"]
        password = os.environ["PYTHON_APP_PASSWORD"]
    except Exception as error:
        exc_info = sys.exc_info()
        print("Error:  Missing env variable '{}'".format(str(exc_info[1])))
        # sys.exit()
        username = "NONE"
        password = "NONE"
    return [username, password]
